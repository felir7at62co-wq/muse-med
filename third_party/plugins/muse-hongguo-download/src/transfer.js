/** Bounded media transfer with validated byte ranges and one joined single-stream fallback. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { DownloadError } from './errors.js';

function responseLength(response, maxBytes, status = 200) {
  if (response.statusCode !== status) throw new DownloadError('http_error', `媒体返回 HTTP ${response.statusCode}`, { httpStatus: response.statusCode });
  const encoding = response.headers['content-encoding'];
  if (encoding && encoding.trim().toLowerCase() !== 'identity') throw new DownloadError('encoding', '媒体使用不支持的传输编码');
  if (/text\/|html|json|mpegurl/i.test(response.headers['content-type'] ?? '')) throw new DownloadError('invalid_media', '服务器返回网页、JSON 或 HLS，下载已拒绝');
  const text = response.headers['content-length'];
  if (text === undefined) return null;
  const bytes = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxBytes) throw new DownloadError('media_size', '媒体长度无效或超过配置的 maxEpisodeBytes');
  return bytes;
}

async function ownResponse(request, url, signal, options, consume) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const wait = async operation => {
    active.throwIfAborted();
    const timer = options.idleTimeoutMs === undefined ? null : setTimeout(() => {
      controller.abort(new DownloadError('network', '媒体请求超过网络静默时限；没有取得完整媒体文件'));
    }, options.idleTimeoutMs);
    try { return await operation(); }
    finally { if (timer !== null) clearTimeout(timer); }
  };
  const response = await wait(() => request(url, 'media', active, options)).catch(error => {
    if (active.aborted && error.name === 'AbortError') throw active.reason;
    throw error;
  });
  const done = finished(response, { cleanup: true }).catch(error => error);
  const abort = () => response.destroy();
  active.addEventListener('abort', abort, { once: true });
  try {
    active.throwIfAborted();
    return await consume(response, active, iterator => nextChunk(iterator, active, wait));
  } catch (error) {
    if (active.aborted && (error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')) throw active.reason;
    throw error;
  } finally {
    active.removeEventListener('abort', abort);
    response.destroy();
    await done;
  }
}

async function writeChunk(file, chunk, position, signal) {
  let offset = 0;
  while (offset < chunk.length) {
    signal.throwIfAborted();
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, position + offset);
    if (!bytesWritten) throw new DownloadError('incomplete_media', '媒体文件写入未完成');
    offset += bytesWritten;
  }
}

async function nextChunk(iterator, signal, wait) {
  try { return await wait(() => iterator.next()); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('network', '媒体流传输中断；没有取得完整媒体文件');
  }
}

async function copyResponse(response, file, signal, start, length, maxBytes, readNext) {
  let bytes = 0;
  const iterator = response[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value: chunk, done } = await readNext(iterator);
      if (done) break;
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > maxBytes) throw new DownloadError('media_size', '媒体超过配置的 maxEpisodeBytes');
      if (length !== null && bytes > length) throw new DownloadError('incomplete_media', '媒体实际长度与来源声明不一致');
      await writeChunk(file, chunk, start + bytes - chunk.length, signal);
    }
    signal.throwIfAborted();
    if (!bytes || (length !== null && bytes !== length)) throw new DownloadError('incomplete_media', '媒体实际长度与来源声明不一致');
    return bytes;
  } finally {
    response.destroy();
    await iterator.return?.().catch(error => error);
  }
}

function requireExpected(bytes, expectedBytes) {
  if (expectedBytes != null && bytes !== expectedBytes) throw new DownloadError('incomplete_media', '媒体实际长度与来源声明不一致');
}

async function digestFile(path, signal) {
  const stream = createReadStream(path, { signal, highWaterMark: 64 * 1024 });
  const done = finished(stream, { cleanup: true }).catch(error => error);
  const digest = createHash('sha256');
  try {
    for await (const chunk of stream) { signal.throwIfAborted(); digest.update(chunk); }
    signal.throwIfAborted();
    return digest.digest('hex');
  } finally { stream.destroy(); await done; }
}

/**
 * Write a new private file through the caller's checked HTTPS request adapter.
 * Range failures cancel and join every request before truncating and retrying one full GET.
 * Optional idleTimeoutMs bounds only response-header and next-chunk waits, excluding file writes.
 * The caller owns removal of the path and MP4, source checksum, decrypt and decode validation.
 * @param {object} options Request adapter, abort signal, allowlists, byte limits and destination.
 * @returns {Promise<{bytes: number, sha256: string}>} Complete source bytes and file SHA-256.
 */
export async function transferMedia({ request, url, signal, headers, allowedHosts, allowedPorts,
  maxBytes, expectedBytes, path, connections, minSegmentBytes, idleTimeoutMs }) {
  const options = { headers, allowedHosts, allowedPorts, idleTimeoutMs };
  signal.throwIfAborted();
  const file = await open(path, 'wx', 0o600);
  try {
    let bytes;
    const initial = await ownResponse(request, url, signal, options, async (response, ownedSignal, readNext) => {
      const total = responseLength(response, maxBytes);
      if (total !== null) requireExpected(total, expectedBytes);
      const etag = response.headers.etag;
      const count = total === null ? 1 : Math.min(connections, Math.floor(total / minSegmentBytes));
      const ranged = count > 1 && /^bytes$/i.test((response.headers['accept-ranges'] ?? '').trim())
        && typeof etag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag);
      if (ranged) return { total, etag, count };
      bytes = await copyResponse(response, file, ownedSignal, 0, total, maxBytes, readNext);
      requireExpected(bytes, expectedBytes);
      return null;
    });
    if (initial) {
      const controller = new AbortController();
      const active = AbortSignal.any([signal, controller.signal]);
      const { total, etag, count } = initial;
      const width = Math.floor(total / count);
      const tasks = Array.from({ length: count }, (_, index) => {
        const start = index * width, end = index === count - 1 ? total - 1 : start + width - 1;
        return ownResponse(request, url, active, { ...options,
          headers: { ...headers, range: `bytes=${start}-${end}`, 'if-match': etag } }, async (response, ownedSignal, readNext) => {
          const length = responseLength(response, maxBytes, 206);
          const range = response.headers['content-range'];
          if (range !== `bytes ${start}-${end}/${total}` || length !== end - start + 1 || response.headers.etag !== etag) {
            throw new DownloadError('incomplete_media', '媒体分段范围、长度或版本不一致');
          }
          return copyResponse(response, file, ownedSignal, start, length, maxBytes, readNext);
        }).catch(error => { controller.abort(error); throw error; });
      });
      const results = await Promise.allSettled(tasks);
      signal.throwIfAborted();
      const failures = results.filter(result => result.status === 'rejected');
      const fatal = failures.find(result => !['network', 'http_error', 'incomplete_media'].includes(result.reason.code));
      if (fatal) throw fatal.reason;
      if (failures.length) {
        await file.truncate(0);
        bytes = await ownResponse(request, url, signal, options, async (response, ownedSignal, readNext) => {
          const length = responseLength(response, maxBytes);
          if (length !== null) requireExpected(length, expectedBytes);
          const actual = await copyResponse(response, file, ownedSignal, 0, length, maxBytes, readNext);
          requireExpected(actual, expectedBytes);
          return actual;
        });
      } else bytes = total;
    }
    signal.throwIfAborted();
    await file.sync();
    return { bytes, sha256: await digestFile(path, signal) };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally { await file.close(); }
}
