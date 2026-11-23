/** Fixed-source original-novel HTTP reads; the metadata reader's whitelist remains unchanged. */
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { abortable, readLegacyResponse } from '../collectors/qimao/transport.js';
import { NovelSourceError } from './source.ts';

const origin = 'https://www.qimao.com';
const book = '\\d{1,24}(?:_0)?';
const allowed = new RegExp(`^(?:/shuku/${book}(?:-\\d{1,30})?/|/qimaoapi/api/book/chapter-list\\?book_id=${book})$`);
const headers = Object.freeze({ accept: 'text/html, application/json', 'accept-encoding': 'identity', 'user-agent': 'Muse-Qimao-Original/0.1' });

/** Bounded anonymous reads of generated book, directory and chapter reference paths. */
export interface QimaoOriginalHttpOptions {
  requestIntervalMs: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  allowLegacyHeaders: boolean;
  fetch?: typeof globalThis.fetch;
}

/** Validates only original-source endpoints, independently from metadataUrl and legacyHtml. */
export function originalSourceUrl(path: string): URL {
  if (!allowed.test(path)) throw new NovelSourceError('invalid_source', '七猫原文来源路径不受支持');
  return new URL(path, origin);
}

async function strict(url: URL, options: QimaoOriginalHttpOptions, signal: AbortSignal): Promise<string> {
  const response = await abortable((options.fetch ?? globalThis.fetch)(url.href, { redirect: 'error', credentials: 'omit', headers, signal }), signal);
  const json = url.pathname === '/qimaoapi/api/book/chapter-list';
  const contentType = response.headers.get('content-type') ?? '', length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
  if (response.status !== 200 || response.redirected || response.url && response.url !== url.href
    || !(json ? /^application\/json(?:;|$)/i : /^text\/html(?:;|$)/i).test(contentType)
    || encoding && encoding.toLowerCase() !== 'identity' || length !== null && (!/^\d+$/.test(length) || Number(length) > options.maxResponseBytes)) {
    await response.body?.cancel(); throw new NovelSourceError('unavailable', '七猫原文请求被拒绝或响应格式无效');
  }
  if (!response.body) throw new NovelSourceError('unavailable', '七猫原文响应为空');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > options.maxResponseBytes) throw new NovelSourceError('unavailable', '七猫原文响应超过字节上限');
      chunks.push(result.value);
    }
    if (length !== null && bytes !== Number(length)) throw new NovelSourceError('unavailable', '七猫原文响应长度不完整');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
}

async function legacy(url: URL, options: QimaoOriginalHttpOptions, signal: AbortSignal): Promise<string> {
  originalSourceUrl(url.pathname + url.search);
  let request: ReturnType<typeof https.request> | undefined, close: () => void = () => {}, activeResponse = false;
  const closed = new Promise<void>(resolve => { close = resolve; });
  const result = new Promise<string>((resolve, reject) => {
    request = https.request(url, { method: 'GET', agent: false, rejectUnauthorized: true, insecureHTTPParser: true, headers, signal }, response => {
      activeResponse = true;
      void readLegacyResponse(response, { maxResponseBytes: options.maxResponseBytes, allowLegacyResponseHeaders: true }, url.pathname === '/qimaoapi/api/book/chapter-list')
        .then(resolve, error => { reject(error); request?.destroy(); });
    });
    request.once('error', reject);
    request.once('close', () => { if (!activeResponse) reject(new NovelSourceError('unavailable', '七猫原文连接在响应前结束')); close(); });
    request.end();
  });
  try { return await result; }
  finally { request?.destroy(); await closed; }
}

/**
 * Creates one paced reader with cancellation and awaited legacy socket closure.
 * @param options Validated request limits and optional fetch implementation.
 * @param dependencies Optional legacy reader with the same completed-response guarantees.
 * @returns A fixed-source text reader without persistent sockets, cookies or account state.
 */
export function createQimaoOriginalReader(options: QimaoOriginalHttpOptions, dependencies: { legacyRequest?: typeof legacy } = {}) {
  let requests = 0;
  return async (path: string, signal: AbortSignal): Promise<string> => {
    const url = originalSourceUrl(path); signal.throwIfAborted();
    if (requests++ && options.requestIntervalMs) await delay(options.requestIntervalMs, undefined, { signal });
    const deadline = AbortSignal.timeout(options.requestTimeoutMs), combined = AbortSignal.any([signal, deadline]);
    try {
      try { return await strict(url, options, combined); }
      catch (error) {
        const outer = error instanceof Error && 'cause' in error ? error.cause : undefined;
        const cause = typeof outer === 'object' && outer !== null ? outer : {};
        const code = 'code' in cause ? cause.code : error instanceof Error && 'code' in error ? error.code : null;
        const folded = 'name' in cause && cause.name === 'HTTPParserError' && 'message' in cause && typeof cause.message === 'string'
          && /Unexpected whitespace after header value/u.test(cause.message) && 'data' in cause && typeof cause.data === 'string'
          && /(?:^|\r\n)[ \t]+(?:content-security-policy|x-frame-options):/iu.test(cause.data);
        if (combined.aborted || !options.allowLegacyHeaders || !(['HPE_INVALID_HEADER_TOKEN', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'].includes(String(code)) || folded)) throw error;
        return await (dependencies.legacyRequest ?? legacy)(url, options, combined);
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof NovelSourceError ? error : new NovelSourceError('unavailable', deadline.aborted ? '七猫原文请求超时' : '七猫原文来源暂不可用');
    }
  };
}
