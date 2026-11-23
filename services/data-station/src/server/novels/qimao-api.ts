/** Complete Qimao originals from the fixed Android app API, independent from anonymous web preview limits. */
import { createDecipheriv, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync, type UnzipFileInfo } from 'fflate';
import { z } from 'zod';
import type { Work } from '../../shared/types.ts';
import { NovelSourceError, type NovelChapter, type NovelDirectory, type NovelSourceAdapter } from './source.ts';

const ORIGIN = 'https://www.qimao.com';
const API_ORIGINS = { bc: 'https://api-bc.wtzw.com', ks: 'https://api-ks.wtzw.com' } as const;
const SIGN_KEY = 'd3dGiJc651gSQ8w1';
/** Fixed AES-128-CBC key shipped by the app for its whole-book cache archive. */
const CIPHER_KEY = Buffer.from('32343263636238323330643730396531', 'hex');
const APPLICATION_HEADERS = { AUTHORIZATION: '', 'app-version': '73720', 'application-id': 'com.****.reader', channel: 'unknown',
  'net-env': '1', platform: 'android', 'qm-params': '', reg: '0' } as const;
const USER_AGENT = 'okhttp/3.12.0';

const identifier = z.string().regex(/^\d{1,24}(?:_0)?$/u);
const numericIdentifier = z.string().regex(/^\d{1,24}$/u);
const chapterIdentifier = z.string().regex(/^\d{1,30}$/u);
const count = z.union([z.number().int().nonnegative().safe(), z.string().regex(/^\d+$/u)]).transform(Number).refine(Number.isSafeInteger);
const seconds = count.refine(value => value <= 32_503_680_000, { message: 'invalid epoch seconds' });
const flag = z.union([z.literal('0'), z.literal('1'), z.literal(0), z.literal(1)]).transform(Number);
const title = z.string().trim().min(1).max(1000);
const detailBook = z.object({ id: z.union([z.number().int().nonnegative().safe(), numericIdentifier]).transform(String), title,
  author: z.string().max(500).nullable().optional(), is_over: flag, chapters: count.optional(),
  latest_chapter_id: chapterIdentifier.optional(), latest_chapter_title: title.optional() }).passthrough();
const detailResponse = z.object({ data: z.object({ id: z.union([z.number().int().nonnegative().safe(), numericIdentifier]).transform(String).optional(),
  book: detailBook }).passthrough() });
const chapterRow = z.object({ id: chapterIdentifier, index: count, title, words: count.optional(), chapter_sort: count,
  update_time: seconds.optional() }).passthrough();
const directoryResponse = z.object({ data: z.object({ id: z.union([z.number().int().nonnegative().safe(), numericIdentifier]).transform(String).optional(),
  chapter_lists: z.array(chapterRow).min(1).max(20_000) }).passthrough() });

const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const UNSAFE_TEXT = /[\p{Co}\uFFFD\uD800-\uDFFF]/u;
const HTML_TAG = /<\/?[a-z!/][^>]*>/iu;
const BLOCK_TAG = /<\/?(?:p|div|br|h[1-6]|li|ol|ul|tr|td|th|table|section|article|blockquote|pre|hr)\b[^>]*>/giu;
const EMBEDDED_DOCUMENT = /<(script|style|iframe|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–' };

/** Limits for one fixed-origin app API session; no account, cookie or redirect leaves the declared hosts. */
export interface QimaoApiNovelOptions {
  requestIntervalMs?: number;
  requestTimeoutMs?: number;
  archiveTimeoutMs?: number;
  maxResponseBytes?: number;
  maxArchiveBytes?: number;
  maxUncompressedBytes?: number;
  maxChapterBytes?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

function invalid(): NovelSourceError { return new NovelSourceError('invalid_source', '七猫全本目录、章节身份或正文完整性未通过核验'); }
function unavailable(message: string): NovelSourceError { return new NovelSourceError('unavailable', message); }
function badArchiveUrl(): NovelSourceError { return new NovelSourceError('invalid_source', '七猫全本缓存包地址未通过固定来源校验'); }

function signature(values: Readonly<Record<string, string>>): string {
  return createHash('md5').update(Object.keys(values).sort().map(key => `${key}=${values[key]}`).join('') + SIGN_KEY).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recognizes the app error envelope without ever forwarding its server-authored text. */
function apiErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || !Object.hasOwn(payload, 'errors')) return null;
  const candidates = Array.isArray(payload.errors) ? payload.errors : [payload.errors];
  for (const candidate of candidates) {
    const parsed = z.object({ code: z.union([z.string().max(100), z.number().int().safe()]) }).passthrough().safeParse(candidate);
    if (parsed.success) return String(parsed.data.code);
  }
  return '';
}

function apiNumber(sourceId: string): string {
  return sourceId.replace(/_0$/u, '');
}

function directoryKey(directory: NovelDirectory): string {
  return createHash('sha256').update(JSON.stringify([directory.workId, directory.sourceId, directory.platform, directory.title, directory.author,
    directory.sourceUrl, directory.observedAt, directory.declaredChapterCount, directory.finished,
    directory.chapters.map(chapter => [chapter.id, chapter.index, chapter.title, chapter.sourceUrl, chapter.wordCount, chapter.sourceUpdatedAt])])).digest('hex');
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ldquo|rdquo|lsquo|rsquo|hellip|mdash|ndash);/giu, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x') || key.startsWith('#')) {
      const codePoint = Number.parseInt(key.startsWith('#x') ? key.slice(2) : key.slice(1), key.startsWith('#x') ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) return '';
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[key] ?? match;
  });
}

/** Converts decrypted app markup or plain prose into the paragraph text the publication library expects. */
function plainText(source: string): string {
  const markup = HTML_TAG.test(source);
  let text = source.replace(/\r\n?/gu, '\n');
  if (markup) {
    text = text.replace(/<!--[\s\S]*?-->/gu, '').replace(EMBEDDED_DOCUMENT, '').replace(BLOCK_TAG, '\n').replace(/<[^>]*>/gu, '');
    text = decodeEntities(text);
  }
  text = text.replace(CONTROL_TEXT, '').replace(/[ \t]+/gu, ' ');
  if (markup) text = text.replace(CONTROL_TEXT, '');
  return text.split('\n').map(line => line.trim()).filter(Boolean).join('\n\n');
}

/** Decrypts one archive entry, or returns null so the caller can fail the whole-book identity check. */
function decryptChapter(entry: Uint8Array): string | null {
  let encoded: string;
  try { encoded = new TextDecoder('utf-8', { fatal: true }).decode(entry); } catch { return null; }
  const compact = encoded.replace(/\s+/gu, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return null;
  const raw = Buffer.from(compact, 'base64');
  if (raw.length < 32 || (raw.length - 16) % 16 !== 0) return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', CIPHER_KEY, raw.subarray(0, 16));
    plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
  } catch { return null; }
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(plain); } catch { return null; }
  const text = plainText(source);
  if (!text || UNSAFE_TEXT.test(text) || CONTROL_TEXT.test(text)) return null;
  return text;
}

function archiveUrl(link: string): URL {
  let target: URL;
  try { target = new URL(link); } catch { throw badArchiveUrl(); }
  const host = target.hostname.toLowerCase();
  if (target.protocol !== 'https:' || (host !== 'wtzw.com' && !host.endsWith('.wtzw.com')) || Boolean(target.username || target.password)
    || Boolean(target.port) && target.port !== '443' || !target.pathname) throw badArchiveUrl();
  return target;
}

interface RemoteLimits { label: string; timeoutMs: number; maxBytes: number; contentType?: RegExp; }

/**
 * Creates a source that reads the app's signed detail and directory and lazily decrypts one whole-book archive per directory.
 * @param options Pacing, timeouts, byte limits and an optional test transport.
 * @returns A source retaining only verified directory metadata and decrypted chapter text until release.
 */
export function createQimaoApiNovelSource(options: QimaoApiNovelOptions = {}): NovelSourceAdapter {
  const config = z.object({ requestIntervalMs: z.number().int().min(100).max(60_000), requestTimeoutMs: z.number().int().min(100).max(120_000),
    archiveTimeoutMs: z.number().int().min(100).max(600_000), maxResponseBytes: z.number().int().min(1024).max(33_554_432),
    maxArchiveBytes: z.number().int().min(1024).max(1_073_741_824), maxUncompressedBytes: z.number().int().min(1024).max(1_073_741_824),
    maxChapterBytes: z.number().int().min(1).max(8_388_608) }).parse({ requestIntervalMs: options.requestIntervalMs ?? 1000,
    requestTimeoutMs: options.requestTimeoutMs ?? 15_000, archiveTimeoutMs: options.archiveTimeoutMs ?? 120_000,
    maxResponseBytes: options.maxResponseBytes ?? 5_242_880, maxArchiveBytes: options.maxArchiveBytes ?? 268_435_456,
    maxUncompressedBytes: options.maxUncompressedBytes ?? 402_653_184, maxChapterBytes: options.maxChapterBytes ?? 2_097_152 });
  const transport = options.fetch ?? globalThis.fetch, now = options.now ?? (() => new Date());
  const applicationSign = signature(APPLICATION_HEADERS);
  const sessions = new Map<string, NovelDirectory>();
  const chapterTexts = new Map<string, Map<string, string>>();
  const loading = new Map<string, Promise<Map<string, string>>>();
  let requestCount = 0, lastRequestAt = 0;

  async function pace(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (requestCount++ > 0) {
      const wait = config.requestIntervalMs - (Date.now() - lastRequestAt);
      if (wait > 0) await delay(wait, undefined, { signal });
    }
    signal.throwIfAborted();
    lastRequestAt = Date.now();
  }

  function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }

  async function remoteBytes(target: URL, headers: Record<string, string>, limits: RemoteLimits, signal: AbortSignal): Promise<Uint8Array> {
    const deadline = AbortSignal.timeout(limits.timeoutMs), combined = AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await transport(target.href, { redirect: 'error', credentials: 'omit', headers, signal: combined });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw unavailable(deadline.aborted ? `${limits.label}请求超时` : `${limits.label}暂不可达`);
    }
    const contentType = response.headers.get('content-type') ?? '', length = response.headers.get('content-length');
    // fetch already decodes a compressed body; a declared content-length then describes the encoded bytes.
    const encoding = (response.headers.get('content-encoding') ?? '').toLowerCase(), encodedLength = encoding !== '' && encoding !== 'identity';
    if (response.status !== 200 || response.redirected || response.url && response.url !== target.href
      || limits.contentType && !limits.contentType.test(contentType)
      || !encodedLength && length !== null && (!/^\d+$/u.test(length) || Number(length) > limits.maxBytes)) {
      await response.body?.cancel().catch(() => {});
      throw unavailable(`${limits.label}响应被拒绝或格式无效`);
    }
    if (!response.body) throw unavailable(`${limits.label}响应为空`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        if (combined.aborted) throw combined.reason;
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > limits.maxBytes) throw unavailable(`${limits.label}响应超过字节上限`);
        chunks.push(result.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted) throw unavailable(`${limits.label}请求超时`);
      throw error instanceof NovelSourceError ? error : unavailable(`${limits.label}响应读取中断`);
    } finally { reader.releaseLock(); }
    if (!encodedLength && length !== null && bytes !== Number(length)) throw unavailable(`${limits.label}响应不完整`);
    return Buffer.concat(chunks);
  }

  async function requestJson(origin: 'bc' | 'ks', path: string, values: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    await pace(signal);
    const params: Record<string, string> = { ...values };
    params.sign = signature(params);
    const target = new URL(`${API_ORIGINS[origin]}${path}`);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    const headers = { ...APPLICATION_HEADERS, sign: applicationSign, 'user-agent': USER_AGENT, accept: 'application/json', 'accept-encoding': 'identity' };
    const bytes = await remoteBytes(target, headers, { label: '七猫应用接口', timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxResponseBytes, contentType: /^application\/json(?:;|$)/iu }, signal);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw unavailable('七猫应用接口响应不是有效 JSON'); }
  }

  async function requestLink(sourceId: string, signal: AbortSignal): Promise<string> {
    const payload = await requestJson('bc', '/api/v1/book/download', { id: sourceId, source: '1', type: '2', is_vip: '1' }, signal);
    if (apiErrorCode(payload) !== null) throw unavailable('七猫暂未生成该书的全本缓存包');
    if (isRecord(payload) && isRecord(payload.data) && typeof payload.data.link === 'string' && payload.data.link.trim()) {
      const id = payload.data.id;
      if (id !== undefined && String(id) !== sourceId) throw invalid();
      return payload.data.link.trim();
    }
    throw unavailable('七猫暂未生成该书的全本缓存包');
  }

  async function requestArchive(link: string, signal: AbortSignal): Promise<Uint8Array> {
    const target = archiveUrl(link);
    await pace(signal);
    return remoteBytes(target, { 'user-agent': USER_AGENT, accept: 'application/zip, application/octet-stream', 'accept-encoding': 'identity' },
      { label: '七猫全本缓存包', timeoutMs: config.archiveTimeoutMs, maxBytes: config.maxArchiveBytes,
        contentType: /^application\/(?:zip|x-zip-compressed|octet-stream)(?:;|$)/iu }, signal);
  }

  /** Verifies that the archive covers exactly the verified directory and decrypts every chapter before caching any text. */
  function archiveTexts(archive: Uint8Array, directory: NovelDirectory): Map<string, string> {
    const ids = new Set(directory.chapters.map(chapter => chapter.id)), maxEntryBytes = config.maxChapterBytes * 2 + 1024;
    const infos: UnzipFileInfo[] = [];
    try { unzipSync(archive, { filter: info => { infos.push(info); return false; } }); }
    catch { throw invalid(); }
    const entries = new Map<string, string>();
    let total = 0;
    for (const info of infos) {
      if (info.name.endsWith('/')) continue;
      const match = /^(?:[^/]+\/)*(\d{1,30})\.txt$/u.exec(info.name);
      const id = match?.[1];
      if (!id || !ids.has(id) || entries.has(id) || !Number.isSafeInteger(info.originalSize) || info.originalSize < 0
        || info.originalSize > maxEntryBytes) throw invalid();
      total += info.originalSize;
      if (!Number.isSafeInteger(total) || total > config.maxUncompressedBytes) throw invalid();
      entries.set(id, info.name);
    }
    if (entries.size !== ids.size) throw invalid();
    const names = new Set(entries.values());
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(archive, { filter: info => names.has(info.name) }); }
    catch { throw invalid(); }
    const texts = new Map<string, string>();
    for (const chapter of directory.chapters) {
      const name = entries.get(chapter.id), entry = name === undefined ? undefined : files[name];
      if (!entry) throw invalid();
      const text = decryptChapter(entry);
      if (!text) throw invalid();
      if (chapter.wordCount !== null && [...text.replace(/\s/gu, '')].length < chapter.wordCount) throw invalid();
      texts.set(chapter.id, text);
    }
    return texts;
  }

  async function loadTexts(directory: NovelDirectory, signal: AbortSignal): Promise<Map<string, string>> {
    const sourceId = apiNumber(directory.sourceId);
    const handle = await requestLink(sourceId, signal);
    const archive = await requestArchive(handle, signal);
    signal.throwIfAborted();
    return archiveTexts(archive, directory);
  }

  function textsFor(directory: NovelDirectory, key: string, signal: AbortSignal): Promise<Map<string, string>> {
    const cached = chapterTexts.get(key);
    if (cached) return Promise.resolve(cached);
    let pending = loading.get(key);
    if (!pending) {
      pending = loadTexts(directory, signal).then(texts => {
        if (sessions.has(key)) chapterTexts.set(key, texts);
        return texts;
      }).finally(() => loading.delete(key));
      loading.set(key, pending);
    }
    return abortable(pending, signal);
  }

  return {
    platform: 'qimao',
    async directory(work: Work, signal: AbortSignal): Promise<NovelDirectory> {
      signal.throwIfAborted();
      if (work.platform !== 'qimao' || work.kind !== 'novel' || work.origin !== 'live' || !identifier.safeParse(work.sourceId).success
        || work.id !== `qimao:${work.sourceId}` || work.sourceUrl !== `${ORIGIN}/shuku/${work.sourceId}/`) throw invalid();
      const sourceId = apiNumber(work.sourceId);
      try {
        const detailPayload = await requestJson('bc', '/api/v4/book/detail', { id: sourceId, imei_ip: '2937357107', teeny_mode: '0' }, signal);
        const detailCode = apiErrorCode(detailPayload);
        if (detailCode !== null) throw unavailable(detailCode === '12010101' ? '七猫该书已下架，原文当前不可用' : '七猫书籍详情接口暂不可用');
        let book: z.infer<typeof detailBook>;
        try { const detail = detailResponse.parse(detailPayload); book = detail.data.book; }
        catch { throw invalid(); }
        if (book.id !== sourceId) throw invalid();
        const listPayload = await requestJson('ks', '/api/v1/chapter/chapter-list', { chapter_ver: '0', id: sourceId }, signal);
        const listCode = apiErrorCode(listPayload);
        if (listCode !== null) throw unavailable('七猫章节目录接口暂不可用');
        let rows: z.infer<typeof chapterRow>[];
        try {
          const list = directoryResponse.parse(listPayload);
          if (list.data.id !== undefined && list.data.id !== sourceId) throw invalid();
          rows = list.data.chapter_lists.slice().sort((left, right) => left.chapter_sort - right.chapter_sort);
        } catch (error) { throw error instanceof NovelSourceError ? error : invalid(); }
        if (rows.some((row, index) => index > 0 && row.chapter_sort <= rows[index - 1]!.chapter_sort)
          || rows.some((row, index) => row.index !== index + 1) || new Set(rows.map(row => row.id)).size !== rows.length) throw invalid();
        const last = rows.at(-1)!;
        if (book.chapters !== undefined && book.chapters !== rows.length) throw invalid();
        if (book.latest_chapter_id !== undefined && book.latest_chapter_id !== last.id) throw invalid();
        if (book.latest_chapter_title !== undefined && book.latest_chapter_title !== last.title) throw invalid();
        const author = book.author?.trim() || null;
        const directory: NovelDirectory = { workId: work.id, sourceId: work.sourceId, platform: 'qimao', title: book.title, author,
          sourceUrl: work.sourceUrl, observedAt: now().toISOString(), declaredChapterCount: rows.length, finished: book.is_over === 1,
          chapters: rows.map((row, index) => ({ id: row.id, index: index + 1, title: row.title,
            sourceUrl: `${ORIGIN}/shuku/${work.sourceId}-${row.id}/`, wordCount: row.words ?? null,
            sourceUpdatedAt: row.update_time === undefined ? null : new Date(row.update_time * 1000).toISOString() })) };
        signal.throwIfAborted();
        sessions.set(directoryKey(directory), directory);
        return directory;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof NovelSourceError) throw error;
        throw invalid();
      }
    },
    async chapter(directory: NovelDirectory, chapter: NovelChapter, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      const key = directoryKey(directory), session = sessions.get(key);
      const expected = session?.chapters.find(item => item.id === chapter.id);
      if (!session || !expected || JSON.stringify([chapter.index, chapter.title, chapter.sourceUrl, chapter.wordCount, chapter.sourceUpdatedAt])
        !== JSON.stringify([expected.index, expected.title, expected.sourceUrl, expected.wordCount, expected.sourceUpdatedAt])) throw invalid();
      try {
        const text = (await textsFor(session, key, signal)).get(chapter.id);
        if (!text || Buffer.byteLength(text) > config.maxChapterBytes) throw invalid();
        signal.throwIfAborted();
        return text;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error instanceof NovelSourceError ? error : invalid();
      }
    },
    async release(directory: NovelDirectory): Promise<void> {
      const key = directoryKey(directory);
      sessions.delete(key); chapterTexts.delete(key);
    },
  };
}
