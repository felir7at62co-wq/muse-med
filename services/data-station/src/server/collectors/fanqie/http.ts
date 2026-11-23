/** Bounded anonymous HTTP shared by Fanqie ranking and catalog metadata collection. */
import { setTimeout as delay } from 'node:timers/promises';

/** Failed batches preserve previous rankings while their verified metadata can resume later. */
export class FanqieCollectionError extends Error {
  constructor(message: string, options?: ErrorOptions, readonly retryable = false) {
    super(`番茄采集失败：${message}`, options);
    this.name = 'FanqieCollectionError';
  }
}

/** Each reader keeps its own request spacing; callers own retries and cancellation. */
export interface FanqieHttpOptions {
  allowedPaths: readonly string[];
  requestTimeoutMs: number;
  requestIntervalMs: number;
  maxResponseBytes: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * Creates a same-origin reader with explicit allowed metadata paths and bounded response bodies.
 * @param options Validated HTTP limits and official paths owned by the caller.
 * @returns A reader that never follows redirects, sends credentials or evaluates scripts.
 */
export function createFanqieMetadataReader(options: FanqieHttpOptions) {
  const { allowedPaths, requestTimeoutMs: timeout, requestIntervalMs: interval, maxResponseBytes: maximum } = options;
  const fetchPage = options.fetch ?? globalThis.fetch;
  const ORIGIN = 'https://fanqienovel.com';
  let requests = 0;
  return async (path: string, format: 'html' | 'json', parentSignal?: AbortSignal): Promise<string> => {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !allowedPaths.includes(url.pathname)) throw new TypeError('Only official Fanqie metadata paths are supported');
    parentSignal?.throwIfAborted();
    if (requests++ > 0 && interval > 0) await delay(interval, undefined, { signal: parentSignal });
    const deadline = AbortSignal.timeout(timeout);
    const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
    try {
      const response = await fetchPage(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal,
        headers: { accept: format === 'json' ? 'application/json' : 'text/html', 'user-agent': 'MuseDataPreview/0.1 (+public novel metadata collector)' } });
      if (response.status !== 200) { await response.body?.cancel(); throw new FanqieCollectionError(`官网返回 HTTP ${response.status}`, undefined, response.status === 429 || response.status >= 500); }
      if (response.redirected || response.url && response.url !== url.href) { await response.body?.cancel(); throw new FanqieCollectionError('官网地址发生跳转'); }
      const type = format === 'html' ? /^text\/html(?:;|$)/i : /^application\/json(?:;|$)/i;
      if (!type.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new FanqieCollectionError('官网没有返回预期的元数据类型'); }
      if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new FanqieCollectionError('官网响应超过大小限制'); }
      if (!response.body) throw new FanqieCollectionError('官网没有返回内容');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0, body = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maximum) { await reader.cancel(); throw new FanqieCollectionError('官网响应超过大小限制'); }
          body += decoder.decode(chunk.value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      return body + decoder.decode();
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      if (error instanceof FanqieCollectionError) throw error;
      throw new FanqieCollectionError(deadline.aborted ? '请求超时' : '网络请求未完成', { cause: error }, true);
    }
  };
}
