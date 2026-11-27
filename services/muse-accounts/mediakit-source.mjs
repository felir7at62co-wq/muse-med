/** Account-scoped readback of Jubian's selected source for paid video processing. */
import {isIP} from 'node:net';

const jubianApi = 'https://web.jubianai.net/prod-api';
const successStatuses = new Set(['succeeded', 'completed']);
const completed = value => typeof value === 'string' && successStatuses.has(value.trim().toLowerCase());
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const nonblank = value => typeof value === 'string' && value.trim() ? value : undefined;
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x21-\x7e]+$/u.test(value);

function matchingId(value, expected, keys) {
  if (!record(value)) return false;
  const ids = keys.filter(key => Object.hasOwn(value, key)).map(key => value[key]);
  return ids.length > 0 && ids.every(id => id === expected || id === String(expected));
}

/** Parse only canonical credential-free HTTPS URLs on DNS hostnames. */
export function canonicalMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const url = URL.parse(value);
  if (!url || url.href !== value || url.protocol !== 'https:' || url.port || url.username || url.password ||
    url.hash || !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.endsWith('.localhost')) return undefined;
  return url;
}

function unwrap(value) {
  const outer = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!record(outer) || (outer.code !== 0 && outer.code !== 200)) return undefined;
  if (!Object.hasOwn(outer, 'data')) return outer;
  const inner = outer.data;
  if (record(inner) && Object.hasOwn(inner, 'code') && Object.hasOwn(inner, 'data')) {
    return inner.code === 0 || inner.code === 200 ? inner.data : undefined;
  }
  return inner;
}

function readSource(row) {
  const result = Array.isArray(row.resultList) ? row.resultList[0] : undefined;
  const material = Array.isArray(row.videoMaterials) ? row.videoMaterials[0] : undefined;
  // Match Jubian's result order and preserve the separate generated and latest files.
  const original = nonblank(result?.tosVideoUrl ?? result?.originalVideoUrl);
  const latest = nonblank(result?.lastTosVideoUrl);
  const current = latest ?? nonblank(result?.tosVideoUrl) ?? nonblank(result?.originalVideoUrl) ?? nonblank(material?.videoUrl);
  return {row, current, original, originalStatus: result?.resultStatus,
    currentStatus: latest === undefined ? result?.resultStatus : result?.lastResultStatus ?? result?.resultStatus};
}

function verifiedDuration(page, input) {
  if (!record(page) || !Array.isArray(page.rows) || !page.rows.every(record)) return undefined;
  const sources = page.rows.map(readSource);
  const original = input.operation === 'erase_subtitle';
  const selected = original ? sources.find(source => source.current !== undefined) ?? sources[0]
    : sources.find(source => source.current !== undefined &&
      (source.row.taskStatus == null || completed(source.row.taskStatus)));
  if (!selected) return undefined;
  const {row} = selected;
  const childId = Number(row.id ?? row.subTaskId);
  const useOriginal = original && selected.original !== undefined;
  const url = useOriginal ? selected.original : selected.current;
  const status = useOriginal ? selected.originalStatus : selected.currentStatus;
  if (url !== input.videoUrl || !positiveId(childId) || !matchingId(row, childId, ['id', 'subTaskId']) ||
    !matchingId(row, input.taskId, ['aigcVideoTaskId']) ||
    (Object.hasOwn(row, 'scriptId') && !matchingId(row, input.scriptId, ['scriptId'])) ||
    (row.taskStatus == null ? !completed(status) : !completed(row.taskStatus)) ||
    (status != null && !completed(status)) || !Number.isFinite(row.duration) || row.duration <= 0) return undefined;
  return row.duration;
}

/**
 * Resolve the selected source with the requesting account's Jubian token.
 * @param {object} [options] Transport and limits for the fixed Jubian API. The deadline covers all reads.
 * @returns {Function} A verifier returning the provider's positive duration in seconds, or undefined when the source cannot be verified.
 */
export function createMediaKitSourceVerifier({fetcher = fetch, timeoutMs = 10000, maximumBytes = 1048576} = {}) {
  if (!positiveId(timeoutMs) || timeoutMs > 2147483647 || !positiveId(maximumBytes)) {
    throw Error('Invalid MediaKit source verification limits');
  }

  async function read(token, path, signal, payload) {
    signal.throwIfAborted();
    const headers = {authorization: `Bearer ${token}`, accept: 'application/json'};
    const init = {method: 'GET', headers, redirect: 'error', signal};
    if (payload !== undefined) {
      init.method = 'POST';
      init.body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
    }
    const response = await fetcher(jubianApi + path, init);
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > maximumBytes) return undefined;
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return unwrap(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size))));
  }

  return async function verify(token, input) {
    if (!validToken(token) || !record(input) || !positiveId(input.scriptId) || !positiveId(input.taskId) ||
      (input.operation !== 'upscale' && input.operation !== 'erase_subtitle') || !canonicalMediaUrl(input.videoUrl)) return undefined;
    const {scriptId, taskId, operation} = input;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const project = await read(token, `/aigc/script/${scriptId}`, signal);
      if (!matchingId(project, scriptId, ['id', 'scriptId'])) return undefined;
      const task = await read(token, `/admin/aigc/video/task/${taskId}`, signal);
      if (!matchingId(task, taskId, ['id', 'taskId']) || !matchingId(task, scriptId, ['scriptId'])) return undefined;
      const path = operation === 'upscale' ? '/admin/aigc/video/task/sub/list?orderByColumn=createTime&orderBy=desc'
        : '/admin/aigc/video/task/sub/list';
      const page = await read(token, path, signal, {aigcVideoTaskId: taskId});
      return verifiedDuration(page, input);
    } catch (_error) {
      // Network, decode and parsing failures cannot authorize a paid operation.
      return undefined;
    }
  };
}
